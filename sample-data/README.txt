ALL DATA IN THIS FOLDER IS FAKE (randomly generated). It is safe to commit.

Generated with 28 fake students.

Planted relationships (so you can check the heat map finds them):
  Statement 1 (AI helps thinking)  <-  tech: Q55, Q57, Q59_1, Q59_5, Q58_*
  Statement 2 (regulate AI)        <-  -tech and -cons: Q59_8, POL_AGREE2_*, POL3
  Statement 3 (community service)  <-  soc and -cons: EXPECT_CHANCE_4/5, LIFE_AGREE_6
  Statement 4 (religion in public) <-  rel and cons: REL3-REL7, REL_AGREE_6, POL3
  Statement 5 (study alone)        <-  -soc: HABITS_FREQ_5, LIFE_AGREE_6
  Statement 6 (teach AI use)       <-  tech: shares a factor with statement 1, so those two should correlate

Do not expect to see them all in a class of ~28: with ~235 comparisons per statement, real moderate
relationships are usually swamped by chance at that size (that is true of real data too).
Regenerate a bigger fake class to watch them appear:  node tools/make-sample-data.js --n 160 --out /some/folder
